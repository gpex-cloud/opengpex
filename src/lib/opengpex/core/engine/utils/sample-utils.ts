/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * sample-utils — the LAZY terminal encode for `SampledPixels`.
 *
 * `capture()` hands back the raw premultiplied-linear working-gamut readback and
 * nothing else. Everything display-facing — un-premultiply, gamut matrix, target
 * TRC, 8-bit quantization — happens HERE, over the tiny block the eyedropper is
 * actually looking at.
 *
 * WHY THIS MODULE EXISTS: encoding the whole ROI up front cost 1.3s of
 * main-thread `Math.pow` on a 4096×4096 snapshot (663ms f32 + 636ms 8-bit,
 * measured) plus ~330MB of transient buffers, all to answer "what colour is the
 * pixel under the cursor" — a 5×5 window, 25 texels, per mouse move. Deferring
 * costs that 5×5 gather per sample and is microseconds.
 *
 * WHERE IT LIVES: `engine/utils/` — this is a PURE CPU pixel helper (no device,
 * no dispatcher, no graph), sibling to `pixel-utils`, and it is imported directly
 * by UI-layer consumers (the sampler overlay, the mosaic brush) the same way
 * `pixel-utils` already is.
 *
 * WHAT IS NOT DEFERRED: the colour math. This calls the same
 * `unpremultiplyEncodeGamutF32` / `unpremultiplyEncodeGamut` helpers the eager
 * path did, with the same arguments, so the single-encode-point
 * invariant and the golden contract
 * `Math.round(float[i] * 255) === rgb8[i]` (exportEncode.test.ts) still hold
 * verbatim — block extraction is a pure re-indexing.
 */

import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import {
  unpremultiplyEncodeGamut,
  unpremultiplyEncodeGamutF32,
} from '@opengpex/editor/core/engine/utils/export-utils';
import { toDisplayTrackCanvasColorSpace } from './pixel-utils';
import type { SampledPixels } from '../types';

/**
 * A decoded rectangle of a {@link SampledPixels}, both tracks, in SNAPSHOT
 * pixel coordinates.
 *
 * `x`/`y`/`w`/`h` are the requested rect CLIPPED to the snapshot, so they may be
 * smaller than asked for near an edge. Index either track with
 * `((py - y) * w + (px - x)) * 4` using snapshot-space `px`/`py` — never with the
 * snapshot's own `width`.
 */
export interface SampledBlock {
  /** Clipped block origin in snapshot pixels. */
  readonly x: number;
  readonly y: number;
  /** Clipped block size in snapshot pixels (`>= 1`). */
  readonly w: number;
  readonly h: number;
  /** Center texel X in snapshot pixels. */
  readonly cx: number;
  /** Center texel Y in snapshot pixels. */
  readonly cy: number;
  /** Byte/channel offset of the center pixel within `float` and `rgb8` (`((cy - y) * w + (cx - x)) * 4`). */
  readonly centerIndex: number;
  /**
   * PRECISION TRUTH: straight, document-gamut, TRC-encoded, un-quantized RGBA
   * (`w*h*4`). The sampler's `float` / CSS `color()` readout reads this — never
   * reconstruct it from {@link rgb8}.
   */
  readonly float: Float32Array;
  /**
   * DISPLAY TRACK: 8-bit RGBA (`w*h*4`) clamped to a canvas-representable gamut
   * — magnifier swatches + hex/rgb8 fallback only, NOT a precision source.
   */
  readonly rgb8: Uint8ClampedArray;
}

/**
 * Sample GPU RAW snapshot pixels at a document WORLD position.
 *
 * Folds world-to-texel projection (`(world - bounds.origin) * scale`), bounds coverage
 * check, window clipping, and lazy dual-track terminal encode (precision float + 8-bit
 * display) into a single call.
 *
 * @param cap Snapshot from `pixels.render.capture()`.
 * @param worldX Target position X in document world coordinates.
 * @param worldY Target position Y in document world coordinates.
 * @param radius Sampling window radius in texels (default 0 = 1×1 pixel, 2 = 5×5 magnifier window).
 * @returns The gathered block with center pixel metadata, or `null` if the center pixel
 *          falls outside the snapshot coverage.
 */
export function sampleGpuRawData(
  cap: SampledPixels,
  worldX: number,
  worldY: number,
  radius: number = 0,
): SampledBlock | null {
  const { linearPixels, width, height, gamut, bounds, scale } = cap;

  // World point → snapshot TEXEL index, folding in origin and scale.
  const cx = Math.floor((worldX - bounds.x) * scale);
  const cy = Math.floor((worldY - bounds.y) * scale);

  // Center pixel must fall inside snapshot coverage.
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
    return null;
  }

  const r = Math.max(0, Math.floor(radius));
  const ox = cx - r;
  const oy = cy - r;
  const rw = r * 2 + 1;
  const rh = r * 2 + 1;

  // Clip the request window to the snapshot.
  const x = Math.max(0, ox);
  const y = Math.max(0, oy);
  const w = Math.min(width, ox + rw) - x;
  const h = Math.min(height, oy + rh) - y;
  if (w <= 0 || h <= 0) return null;

  // Gather the sub-rect into a contiguous w×h RGBA buffer: the encoders take a
  // packed `width*height*4` buffer, and a row-strided view is not that.
  const rowFloats = w * 4;
  const src = new Float32Array(rowFloats * h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * width + x) * 4;
    src.set(linearPixels.subarray(from, from + rowFloats), row * rowFloats);
  }

  // Both encoders are pure (each allocates its own output), so one gathered
  // `src` feeds both passes.
  const float = unpremultiplyEncodeGamutF32(src, w, h, {
    sourceGamut: WORKING_GAMUT,
    targetGamut: gamut,
  });
  const rgb8 = unpremultiplyEncodeGamut(src, w, h, {
    sourceGamut: WORKING_GAMUT,
    // Display track: clamp to what a canvas can actually tag (see pixel-utils).
    targetGamut: toDisplayTrackCanvasColorSpace(gamut),
    bitDepth: 8,
  }) as Uint8ClampedArray;

  const centerIndex = ((cy - y) * w + (cx - x)) * 4;

  return { x, y, w, h, cx, cy, centerIndex, float, rgb8 };
}

/**
 * EAGER whole-snapshot encode → display-track `ImageData`.
 *
 * ONLY for callers that genuinely consume every pixel — the mosaic brush, which
 * block-averages the entire composite once per stroke session. This is the exact
 * cost {@link sampleGpuRawData} exists to avoid (hundreds of ms of `Math.pow`
 * on a large snapshot), so do NOT reach for it on an interactive path: an
 * eyedropper wants a 5×5 block, not 16 million pixels.
 *
 * The 8-bit track only, tagged with the canvas colour space the display track was
 * encoded for — `ImageData` cannot carry `adobe-rgb`/`prophoto-rgb`, so wide-gamut
 * documents land in `display-p3` exactly as the old eager `capture()` produced them.
 */
export function sampleImageData(cap: SampledPixels): ImageData {
  const rgb8 = unpremultiplyEncodeGamut(cap.linearPixels, cap.width, cap.height, {
    sourceGamut: WORKING_GAMUT,
    targetGamut: toDisplayTrackCanvasColorSpace(cap.gamut),
    bitDepth: 8,
  }) as Uint8ClampedArray;
  // Zero-copy re-view: the encoder's return type is `Uint8ClampedArray<ArrayBufferLike>`,
  // while `ImageData` demands an `ArrayBuffer`-backed one. The encoder allocates a
  // plain array (never a SharedArrayBuffer), so this narrows the type without
  // touching the bytes.
  const bytes = new Uint8ClampedArray(rgb8.buffer as ArrayBuffer, rgb8.byteOffset, rgb8.length);
  return new ImageData(bytes, cap.width, cap.height, {
    colorSpace: toDisplayTrackCanvasColorSpace(cap.gamut),
  });
}
