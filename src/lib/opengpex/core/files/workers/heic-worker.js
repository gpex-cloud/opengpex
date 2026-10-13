/**
 * OpenGPEX - HEIC decode Worker (libheif proxy + WebCodecs hard decode)
 *
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * One files-layer worker serving BOTH HEIC decode channels (lazily loaded by
 * the HEIC handler):
 *
 *   - `decodeProxy` — 'libheif-proxy' channel (rules 19b/19c/19e): libheif wasm
 *     RGBA-8 direct output, NO canvas round-trip (the canvas sRGB semantics
 *     were exactly the wash-out mechanism of the retired JPEG-q0.95 transcode
 *     path). libheif initializes lazily — a hard-decode-only session never
 *     pays the ~3 MB wasm load.
 *   - `decodeHard` — 'webcodecs-heic' channel (rule 19a): VideoDecoder hardware
 *     decode per tile, tile extraction, orientation-applied grid composition.
 *     No WebCodecs config beyond {codec, description} —
 *     hardwareAcceleration/colorSpace were probe-measured as ineffective.
 *
 * Protocol: { id, fn, args } → { id, out } | { id, error } (isomorphic with the
 * other files-layer workers).
 *
 * `decodeHard` payload:
 *   { codec, description: Uint8Array,
 *     tiles: [{ data: Uint8Array, gridRow, gridCol }],
 *     grid?: { rows, cols, outputWidth, outputHeight },
 *     codedWidth, codedHeight,
 *     orientation: { irotQuarterTurns, imirAxis, exifOrientation },
 *     matrix: '709' | '2020', fullRange: boolean }
 * → { rgba: Uint8ClampedArray, width, height, timings }
 *
 * Tile extraction has TWO lanes, decided per decode by capability:
 *   1. RGBA conversion copy — `copyTo(buf, { format: 'RGBA' })`: one call, the
 *      GPU's own YUV→RGB. Verified faithful (meanDev 1.15 vs libheif on the
 *      12MP truth sample). Works around Chromium builds whose plane-index
 *      copyTo is broken for hardware frames (planeIndex ignored → every plane
 *      returns the Y plane → green/magenta cast; diagnosed 2026-10-13).
 *   2. Per-plane copy + fixed-point YUV→RGB ({@link yuvTileToRgba}) — the
 *      probe-validated lane for builds without conversion-copy support
 *      (real Chrome 152). NV12/I420, bilinear chroma, integer-only math.
 *
 * Orientation contract: the composed (stored-space) image is uprighted by ONE
 * inverse-mapped scatter pass during tile placement — never per-tile rotation.
 * Rule (rev5 §2.2 point 9, empirically corrected): container irot/imir when
 * non-zero (irot first, then imir in destination space), else EXIF 2..8. The
 * angle lives in the LOW 2 bits (irot=3 ⇒ 90° CW); Apple photos carry irot=3 +
 * EXIF 6 as the same rotation tagged twice.
 *
 * NAL discipline: tiles are length-prefixed hvc1 streams fed VERBATIM (the
 * description-present semantics); no Annex-B conversion — that route is dead
 * on both target browsers.
 *
 * Resource discipline: frames close() immediately after plane extraction; the
 * decoder closes in `finally` (failure paths included); copyTo promises are
 * awaited before close (close cancels in-flight copies).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Channel: decodeProxy (libheif)
// ═══════════════════════════════════════════════════════════════════════════════

let libheifModule = null;

async function initLibheif() {
  if (libheifModule) return libheifModule;

  importScripts('/ext/wasm/libheif/libheif.js');

  libheifModule = await self.libheif({
    locateFile: (fileName) => `/ext/wasm/libheif/${fileName}`,
  });
  return libheifModule;
}

async function decodeProxy(buffer) {
  const mod = await initLibheif();

  const decoder = new mod.HeifDecoder();
  let images = null;
  try {
    images = decoder.decode(buffer);
    if (!images || images.length === 0) {
      throw new Error('HEIC: no decodable image found');
    }

    // Primary image first; fall back to the first top-level image (single-image
    // files where the writer never marked a primary — libheif tolerates both).
    let image = null;
    for (const candidate of images) {
      if (candidate.is_primary()) { image = candidate; break; }
    }
    if (!image) image = images[0];

    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) {
      throw new Error(`HEIC: invalid primary dimensions ${width}x${height}`);
    }

    const imageData = { width, height, data: new Uint8ClampedArray(width * height * 4) };

    const displayed = await new Promise((resolve) => {
      image.display(imageData, (out) => resolve(out));
    });
    if (!displayed) throw new Error('HEIC: primary image decode failed');

    return { width, height, rgba: displayed.data };
  } finally {
    // Free every handle, then the context. HeifDecoder only frees the context
    // lazily on its NEXT decode — without this explicit free, one context (and
    // its whole heap view of the file) would stay pinned per worker lifetime.
    if (images) {
      for (const img of images) {
        try { img.free(); } catch { /* already gone — freeing is best-effort */ }
      }
    }
    try {
      // `decoder.decoder` is the libheif context handle in the pinned
      // libheif-js 1.23.5 glue (exact version pin in package.json).
      if (decoder.decoder) {
        mod.heif_context_free(decoder.decoder);
        decoder.decoder = null;
      }
    } catch { /* best-effort */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Channel: decodeHard (WebCodecs) — pure helpers (kept top-level for tests)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fixed-point YUV→RGB coefficients ×1024 (>>10 shift). Per-channel form:
 *   R = (luma*C + cr*E          + 512) >> 10
 *   G = (luma*C - cbG*D - crG*E + 512) >> 10
 *   B = (luma*C + cb*D          + 512) >> 10
 * where C = luma (limited: Y-16, full: Y), D = Cb-128, E = Cr-128. Integer
 * only: identical inputs always produce identical outputs (no float jitter
 * across tiles).
 */
const YUV_COEFFS = {
  '709-limited': { luma: 1192, cr: 1836, cbG: 218, crG: 546, cb: 2162 },
  '2020-limited': { luma: 1192, cr: 1718, cbG: 192, crG: 666, cb: 2193 },
  '709-full': { luma: 1024, cr: 1613, cbG: 192, crG: 479, cb: 1900 },
  '2020-full': { luma: 1024, cr: 1510, cbG: 168, crG: 585, cb: 1926 },
};

function yuvCoeffs(matrix, fullRange) {
  const key = `${matrix}-${fullRange ? 'full' : 'limited'}`;
  return YUV_COEFFS[key] || YUV_COEFFS['709-limited'];
}

/**
 * Detect the real row stride of a copied VideoFrame LUMA plane. copyTo gives
 * no stride introspection, and byte counts cannot distinguish row vs tail
 * padding (512-wide tiles measured stride 768; 896-wide tiles measured tight)
 * — so run the probe-validated vertical-autocorrelation argmin over candidate
 * strides. Luma-sized (bytes) only: chroma planes share the luma byte stride
 * in practice and must NOT be probed with texel-width (wrong pitch → hue cast).
 */
function detectPlaneStride(buf, width, height, allocSize) {
  if (allocSize <= width * height || height < 2) return width;
  const maxStride = Math.min(Math.floor(allocSize / (height - 1)), width + 1024);
  let best = width;
  let bestSad = Infinity;
  const rowPairs = Math.min(12, height - 1);
  for (let s = width; s <= maxStride; s++) {
    let sad = 0;
    let ok = true;
    for (let r = 1; r <= rowPairs; r++) {
      const y0 = Math.min(height - 2, Math.round((r * (height - 1)) / rowPairs));
      const a = y0 * s;
      const b = (y0 + 1) * s;
      if (b + width > buf.length) { ok = false; break; }
      for (let x = 0; x < width; x += 3) {
        sad += Math.abs(buf[a + x] - buf[b + x]);
      }
    }
    if (ok && sad < bestSad) { bestSad = sad; best = s; }
  }
  return best;
}

/**
 * Convert one decoded tile (NV12 or I420, 4:2:0) to RGBA-8 — bilinear chroma
 * upsampling, processed per 2×2 output block (the four pixels share the same
 * four chroma texels with fixed 0.25/0.75 weights). Integer math throughout.
 *
 * @returns {Uint8ClampedArray} w*h*4
 */
function yuvTileToRgba(fmt, y, yStride, u, uStride, v, vStride, uv, uvStride, w, h, coeffs) {
  const out = new Uint8ClampedArray(w * h * 4);
  const { luma, cr: kCr, cbG: kCbG, crG: kCrG, cb: kCb } = coeffs;
  const cw = (w + 1) >> 1;
  const chh = (h + 1) >> 1;
  const clamp1 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  for (let by = 0; by < chh; by++) {
    for (let bx = 0; bx < cw; bx++) {
      // 2×2 output pixels (j = x parity, i = y parity). Pixel-center mapping:
      // x = 2bx   → chroma column between bx-1 and bx (weight 0.75 on bx)
      // x = 2bx+1 → chroma column between bx   and bx+1 (weight 0.25 on bx+1)
      // (rows analogously; edges clamp).
      for (let pi = 0; pi < 4; pi++) {
        const j = pi & 1;
        const i = pi >> 1;
        const x = 2 * bx + j;
        const y2 = 2 * by + i;
        if (x >= w || y2 >= h) continue;
        const iuL = j === 0 ? (bx > 0 ? bx - 1 : 0) : bx;
        const iuR = j === 0 ? bx : (bx + 1 < cw ? bx + 1 : cw - 1);
        const fX = j === 0 ? 0.75 : 0.25; // weight of the RIGHT texel
        const ivTop = i === 0 ? (by > 0 ? by - 1 : 0) : by;
        const ivBot = i === 0 ? by : (by + 1 < chh ? by + 1 : chh - 1);
        const fY = i === 0 ? 0.75 : 0.25; // weight of the BOTTOM texel row
        let cb;
        let cr;
        if (uv) {
          const uL = uv[ivTop * uvStride + iuL * 2];
          const uR = uv[ivTop * uvStride + iuR * 2];
          const uB0 = uv[ivBot * uvStride + iuL * 2];
          const uB1 = uv[ivBot * uvStride + iuR * 2];
          const vL = uv[ivTop * uvStride + iuL * 2 + 1];
          const vR = uv[ivTop * uvStride + iuR * 2 + 1];
          const vB0 = uv[ivBot * uvStride + iuL * 2 + 1];
          const vB1 = uv[ivBot * uvStride + iuR * 2 + 1];
          cb = (uL * (1 - fX) + uR * fX) * (1 - fY) + (uB0 * (1 - fX) + uB1 * fX) * fY;
          cr = (vL * (1 - fX) + vR * fX) * (1 - fY) + (vB0 * (1 - fX) + vB1 * fX) * fY;
        } else {
          const uL = u[ivTop * uStride + iuL];
          const uR = u[ivTop * uStride + iuR];
          const uB0 = u[ivBot * uStride + iuL];
          const uB1 = u[ivBot * uStride + iuR];
          const vL = v[ivTop * vStride + iuL];
          const vR = v[ivTop * vStride + iuR];
          const vB0 = v[ivBot * vStride + iuL];
          const vB1 = v[ivBot * vStride + iuR];
          cb = (uL * (1 - fX) + uR * fX) * (1 - fY) + (uB0 * (1 - fX) + uB1 * fX) * fY;
          cr = (vL * (1 - fX) + vR * fX) * (1 - fY) + (vB0 * (1 - fX) + vB1 * fX) * fY;
        }

        const Y = y[y2 * yStride + x];
        const C = luma === 1192 ? Y - 16 : Y;
        const D = cb - 128;
        const E = cr - 128;
        const o = (y2 * w + x) * 4;
        out[o] = clamp1((luma * C + kCr * E + 512) >> 10);
        out[o + 1] = clamp1((luma * C - kCbG * D - kCrG * E + 512) >> 10);
        out[o + 2] = clamp1((luma * C + kCb * D + 512) >> 10);
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

/**
 * Orientation plan for the composition scatter.
 * code (closed-form dest→src inverse):
 *   0 identity · 1 90°CCW · 2 180 · 3 90°CW · 4 flip-H · 5 flip-V
 *   6 transpose (EXIF5) · 7 transverse (EXIF7)
 * flipX/flipY = destination-space mirror applied AFTER the rotation (imir).
 */
function orientationPlan(composedW, composedH, ori) {
  const irot = ori.irotQuarterTurns | 0;
  const imir = ori.imirAxis;
  if (irot !== 0 || (imir !== null && imir !== undefined)) {
    const code = irot === 1 ? 1 : irot === 2 ? 2 : irot === 3 ? 3 : 0;
    const swap = code === 1 || code === 3;
    return {
      outW: swap ? composedH : composedW,
      outH: swap ? composedW : composedH,
      code,
      flipX: imir === 0, // axis 0 = mirror across the vertical axis (flip X)
      flipY: imir === 1, // axis 1 = mirror across the horizontal axis (flip Y)
    };
  }
  switch (ori.exifOrientation ?? 1) {
    case 2: return { outW: composedW, outH: composedH, code: 4, flipX: false, flipY: false };
    case 3: return { outW: composedW, outH: composedH, code: 2, flipX: false, flipY: false };
    case 4: return { outW: composedW, outH: composedH, code: 5, flipX: false, flipY: false };
    case 5: return { outW: composedH, outH: composedW, code: 6, flipX: false, flipY: false };
    case 6: return { outW: composedH, outH: composedW, code: 3, flipX: false, flipY: false };
    case 7: return { outW: composedH, outH: composedW, code: 7, flipX: false, flipY: false };
    case 8: return { outW: composedH, outH: composedW, code: 1, flipX: false, flipY: false };
    default: return { outW: composedW, outH: composedH, code: 0, flipX: false, flipY: false };
  }
}

/** dest(xd,yd) → composed(xs,ys). Mirroring inverts FIRST (it is dest-space). */
function mapInverse(plan, xdIn, ydIn) {
  const xd = plan.flipX ? plan.outW - 1 - xdIn : xdIn;
  const yd = plan.flipY ? plan.outH - 1 - ydIn : ydIn;
  switch (plan.code) {
    case 1: return [plan.outH - 1 - yd, xd];               // 90° CCW
    case 2: return [plan.outW - 1 - xd, plan.outH - 1 - yd]; // 180
    case 3: return [yd, plan.outW - 1 - xd];               // 90° CW (Hs = outW, swapped)
    case 4: return [plan.outW - 1 - xd, yd];               // flip H
    case 5: return [xd, plan.outH - 1 - yd];               // flip V
    case 6: return [yd, xd];                               // transpose
    case 7: return [plan.outH - 1 - yd, plan.outW - 1 - xd]; // transverse
    default: return [xd, yd];                              // identity
  }
}

/** composed(xs,ys) → dest(xd,yd) — exact inverse of {@link mapInverse}. */
function mapForward(plan, xs, ys) {
  let xd;
  let yd;
  switch (plan.code) {
    case 1: xd = ys; yd = plan.outH - 1 - xs; break;
    case 2: xd = plan.outW - 1 - xs; yd = plan.outH - 1 - ys; break;
    case 3: xd = plan.outW - 1 - ys; yd = xs; break;
    case 4: xd = plan.outW - 1 - xs; yd = ys; break;
    case 5: xd = xs; yd = plan.outH - 1 - ys; break;
    case 6: xd = ys; yd = xs; break;
    case 7: xd = plan.outW - 1 - ys; yd = plan.outH - 1 - xs; break;
    default: xd = xs; yd = ys;
  }
  return [plan.flipX ? plan.outW - 1 - xd : xd, plan.flipY ? plan.outH - 1 - yd : yd];
}

/**
 * Scatter one converted tile into the final buffer through the orientation
 * inverse map (single full-frame buffer, no second copy; edge tiles clipped by
 * the grid's output size).
 */
function scatterTile(tileRgba, w, h, tile, tileW, tileH, composedW, composedH, plan, out) {
  const regionX = (tile.gridCol ?? 0) * tileW;
  const regionY = (tile.gridRow ?? 0) * tileH;
  const regionW = Math.min(w, composedW - regionX);
  const regionH = Math.min(h, composedH - regionY);

  // Destination bbox = the region's four corners, forward-mapped (all codes
  // map axis-aligned rects to axis-aligned rects).
  const corners = [
    mapForward(plan, regionX, regionY),
    mapForward(plan, regionX + regionW - 1, regionY),
    mapForward(plan, regionX, regionY + regionH - 1),
    mapForward(plan, regionX + regionW - 1, regionY + regionH - 1),
  ];
  let minX = plan.outW;
  let minY = plan.outH;
  let maxX = -1;
  let maxY = -1;
  for (const [xd, yd] of corners) {
    if (xd < minX) minX = xd;
    if (xd > maxX) maxX = xd;
    if (yd < minY) minY = yd;
    if (yd > maxY) maxY = yd;
  }
  minX = Math.max(0, minX);
  minY = Math.max(0, minY);
  maxX = Math.min(plan.outW - 1, maxX);
  maxY = Math.min(plan.outH - 1, maxY);

  for (let yd = minY; yd <= maxY; yd++) {
    for (let xd = minX; xd <= maxX; xd++) {
      const [xs, ys] = mapInverse(plan, xd, yd);
      if (xs < regionX || xs >= regionX + regionW || ys < regionY || ys >= regionY + regionH) continue;
      const src = ((ys - regionY) * w + (xs - regionX)) * 4;
      const dst = (yd * plan.outW + xd) * 4;
      out[dst] = tileRgba[src];
      out[dst + 1] = tileRgba[src + 1];
      out[dst + 2] = tileRgba[src + 2];
      out[dst + 3] = 255;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// decodeHard — pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function decodeHard(payload) {
  const t0 = performance.now();
  const {
    codec, description,
    tiles, grid,
    codedWidth, codedHeight,
    orientation,
    matrix = '709', fullRange = false,
  } = payload;

  if (typeof VideoDecoder === 'undefined') {
    throw new Error('WebCodecs VideoDecoder unavailable in this context');
  }

  const composedW = grid ? grid.outputWidth : codedWidth;
  const composedH = grid ? grid.outputHeight : codedHeight;
  const tileW = codedWidth;
  const tileH = codedHeight;

  const plan = orientationPlan(composedW, composedH, orientation || {});
  const out = new Uint8ClampedArray(plan.outW * plan.outH * 4);
  const coeffs = yuvCoeffs(matrix, fullRange);

  const frames = new Map();   // timestamp → VideoFrame (arrived before awaited)
  const waiters = new Map();  // timestamp → resolver (awaiting a frame)
  let decodeError = null;
  let extractionMode = null; // 'rgba-copy' | 'planes', decided on the first frame
  const decoder = new VideoDecoder({
    output: (frame) => {
      const w = waiters.get(frame.timestamp);
      if (w) {
        waiters.delete(frame.timestamp);
        w(frame);
      } else {
        frames.set(frame.timestamp, frame);
      }
    },
    error: (err) => { decodeError = err; },
  });

  try {
    decoder.configure({ codec, description });

    let convertMs = 0;
    let composeMs = 0;

    for (let index = 0; index < tiles.length; index++) {
      if (decodeError) throw decodeError;
      const tile = tiles[index];
      // Backpressure: keep the hardware queue shallow (probe-validated shape).
      while (decoder.decodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 0));
      }
      decoder.decode(new EncodedVideoChunk({
        type: 'key',
        timestamp: index,
        data: tile.data,
      }));

      // The output callback usually fires inside decode(); pair THIS tile's
      // frame by timestamp (promise hand-off — no polling latency).
      const frame = await new Promise((resolve, reject) => {
        const landed = frames.get(index);
        if (landed) {
          frames.delete(index);
          resolve(landed);
          return;
        }
        waiters.set(index, resolve);
        setTimeout(() => {
          if (waiters.delete(index)) reject(new Error(`tile ${index}: decoder produced no frame`));
        }, 30000);
        void reject;
      });
      if (decodeError) throw decodeError;
      try {
        const tConvert = performance.now();
        const w = frame.displayWidth || frame.codedWidth;
        const h = frame.displayHeight || frame.codedHeight;
        let tileRgba;

        if (extractionMode === null) {
          try {
            frame.allocationSize({ format: 'RGBA' });
            extractionMode = 'rgba-copy';
          } catch {
            extractionMode = 'planes';
          }
        }

        if (extractionMode === 'rgba-copy') {
          // One call, the GPU's own YUV→RGB; output is a tight w×h RGBA buffer
          // in the frame's (stored-space) coordinate system.
          const size = frame.allocationSize({ format: 'RGBA' });
          const buf = new Uint8Array(size);
          await frame.copyTo(buf, { format: 'RGBA' });
          tileRgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
        } else {
          // Per-plane lane (probe-validated on real Chrome 152). copyTo is
          // ASYNC — always await, and finish before frame.close() below
          // (close cancels in-flight copies → zero chroma).
          const fmt = frame.format;
          if (fmt !== 'NV12' && fmt !== 'I420') {
            // 19a is 8-bit only; an opaque GPU frame here means the capability
            // probe and the real decoder disagree — Fail-Fast, never a silent
            // fallback.
            throw new Error(`unexpected VideoFrame format: ${String(fmt)} (opaque GPU frame?)`);
          }
          const yAlloc = frame.allocationSize({ planeIndex: 0 });
          const yBuf = new Uint8Array(yAlloc);
          await frame.copyTo(yBuf, { planeIndex: 0 });
          const yStride = detectPlaneStride(yBuf, w, h, yAlloc);

          // Chroma planes share the LUMA byte stride in every observed decoder
          // layout; probing them with texel-width gives a wrong pitch.
          const chromaRows = (h + 1) >> 1;
          let uv = null;
          let uvStride = 0;
          let u = null;
          let uStride = 0;
          let v = null;
          let vStride = 0;
          if (fmt === 'NV12') {
            const alloc = frame.allocationSize({ planeIndex: 1 });
            uv = new Uint8Array(alloc);
            await frame.copyTo(uv, { planeIndex: 1 });
            uvStride = alloc >= yStride * chromaRows
              ? yStride
              : detectPlaneStride(uv, w, chromaRows, alloc);
          } else {
            const uAlloc = frame.allocationSize({ planeIndex: 1 });
            u = new Uint8Array(uAlloc);
            await frame.copyTo(u, { planeIndex: 1 });
            uStride = uAlloc >= yStride * chromaRows
              ? yStride
              : detectPlaneStride(u, (w + 1) >> 1, chromaRows, uAlloc);
            const vAlloc = frame.allocationSize({ planeIndex: 2 });
            v = new Uint8Array(vAlloc);
            await frame.copyTo(v, { planeIndex: 2 });
            vStride = vAlloc >= yStride * chromaRows
              ? yStride
              : detectPlaneStride(v, (w + 1) >> 1, chromaRows, vAlloc);
          }
          tileRgba = yuvTileToRgba(fmt, yBuf, yStride, u, uStride, v, vStride, uv, uvStride, w, h, coeffs);
        }
        convertMs += performance.now() - tConvert;

        const tCompose = performance.now();
        scatterTile(tileRgba, w, h, tile, tileW, tileH, composedW, composedH, plan, out);
        composeMs += performance.now() - tCompose;
      } finally {
        frame.close();
      }
    }

    await decoder.flush();
    decoder.close();

    return {
      rgba: out,
      width: plan.outW,
      height: plan.outH,
      timings: {
        convertMs: +convertMs.toFixed(1),
        composeMs: +composeMs.toFixed(1),
        totalMs: +(performance.now() - t0).toFixed(1),
      },
    };
  } catch (err) {
    try { if (decoder.state !== 'closed') decoder.close(); } catch { /* already closed */ }
    for (const frame of frames.values()) {
      try { frame.close(); } catch { /* best effort */ }
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler — { id, fn, args } → { id, out } | { id, error }
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { decodeProxy, decodeHard };

self.onmessage = async ({ data: msg }) => {
  const { id, fn, args } = msg;
  const handler = handlers[fn];
  if (!handler) {
    self.postMessage({ id, error: `Unknown function: ${fn}` });
    return;
  }
  try {
    const out = await handler(...(args || []));
    const transfer = [];
    if (out && typeof out === 'object' && out.rgba instanceof Uint8ClampedArray && out.rgba.buffer) {
      transfer.push(out.rgba.buffer);
    }
    self.postMessage({ id, out }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
