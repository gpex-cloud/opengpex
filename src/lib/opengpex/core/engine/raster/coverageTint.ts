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
 * coverageTint.ts — Coverage-mask × solid-tint compositing.
 * Turns one or more Canvas2D-rasterized alpha coverage masks into
 * a single straight-alpha `rgba16float` buffer, tagged with a `GamutId`, ready
 * for the same `highDepthSource` ingestion seam as `buildSolidColorSource`.
 *
 * Pure module — no DOM/Canvas types here; `paintText.ts` / `paintMarker.ts`
 * own the OffscreenCanvas readback and call into this module.
 *
 * @module core/raster/coverageTint
 */

import { convertColorGamut, type ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';
import type { GamutId } from '@opengpex/editor/core/types/primitives';

/** One coverage-masked tint layer to composite, bottom of the stack first. */
export interface CoverageLayer {
  /** Per-pixel coverage, 0..1, length === width*height (row-major). */
  readonly coverage: Float32Array;
  /** Scalar opacity multiplier, independent of `tint.alpha` (e.g. `fill.opacity`). */
  readonly opacity: number;
  readonly tint: ColorValue;
}

/** Composited high-depth buffer: straight-alpha RGBA16F, tagged with its gamut. */
export interface CompositedCoverage {
  readonly data: Uint16Array;
  readonly space: GamutId;
}

/**
 * Extracts a 0..1 coverage mask from a white-on-transparent Canvas2D alpha
 * channel (`ImageData.data`, RGBA8 interleaved) — the alpha byte IS the
 * coverage, since the paint was pure white with no other alpha modifiers.
 */
export function resolveCoverageAlpha(pixelData: Uint8ClampedArray): Float32Array {
  const pixelCount = pixelData.length / 4;
  const coverage = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    coverage[i] = pixelData[i * 4 + 3] / 255;
  }
  return coverage;
}

/**
 * Composites one or more coverage-masked tints into a single straight-alpha
 * `rgba16float` buffer.
 *
 * Single layer: no gamut conversion (avoids needless precision loss) — RGB is
 * the per-pixel constant `tint.coords`, alpha is `coverage[i] * opacity`.
 *
 * Multiple layers: aligned to `layers[0].tint.space` via `convertColorGamut`
 * when a layer's space differs, then composited bottom→top with standard
 * straight-alpha "over" — matching Canvas2D's own sequential `fill()`/
 * `stroke()` calls pixel-for-pixel (gamma-domain, no linearization).
 *
 * Never reads `tint.alpha` — mirrors the existing Canvas2D callers, which only
 * ever consume `.color.hex` (no alpha channel) and `fill.opacity`/`1`.
 */
export function compositeCoverageTints(
  width: number,
  height: number,
  layers: readonly CoverageLayer[],
): CompositedCoverage {
  const pixelCount = width * height;
  const data = new Uint16Array(pixelCount * 4);
  if (layers.length === 0) {
    return { data, space: 'srgb' };
  }

  const outSpace = layers[0].tint.space;

  if (layers.length === 1) {
    const layer = layers[0];
    const { r, g, b } = layer.tint.coords;
    const hr = floatToHalf(r);
    const hg = floatToHalf(g);
    const hb = floatToHalf(b);
    for (let i = 0; i < pixelCount; i++) {
      const a = layer.coverage[i] * layer.opacity;
      data[i * 4] = hr;
      data[i * 4 + 1] = hg;
      data[i * 4 + 2] = hb;
      data[i * 4 + 3] = floatToHalf(a);
    }
    return { data, space: outSpace };
  }

  const aligned = layers.map((layer) =>
    layer.tint.space === outSpace ? layer.tint : convertColorGamut(layer.tint, outSpace),
  );

  for (let i = 0; i < pixelCount; i++) {
    // Accumulate PREMULTIPLIED (standard Porter-Duff "over"), then un-premultiply
    // once at the end — the layer loop's running `outA` is each step's dst alpha.
    let premultR = 0;
    let premultG = 0;
    let premultB = 0;
    let outA = 0;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const srcA = layer.coverage[i] * layer.opacity;
      if (srcA <= 0) continue;
      const { r, g, b } = aligned[li].coords;
      const invA = 1 - srcA;
      premultR = r * srcA + premultR * invA;
      premultG = g * srcA + premultG * invA;
      premultB = b * srcA + premultB * invA;
      outA = srcA + outA * invA;
    }
    data[i * 4] = floatToHalf(outA > 0 ? premultR / outA : 0);
    data[i * 4 + 1] = floatToHalf(outA > 0 ? premultG / outA : 0);
    data[i * 4 + 2] = floatToHalf(outA > 0 ? premultB / outA : 0);
    data[i * 4 + 3] = floatToHalf(outA);
  }

  return { data, space: outSpace };
}
