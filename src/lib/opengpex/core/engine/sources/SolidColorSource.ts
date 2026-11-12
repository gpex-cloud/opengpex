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
 * solidColorSource.ts — encode a structured {@link ColorValue} as a 1×1
 * wide-gamut GPU "solid-colour source".
 *
 * WHY THIS EXISTS: a `color` layer is a pure fill. The legacy path rasterised it
 * with Canvas2D `fillStyle = hex` (`rasterizer.ts` `drawLayerContent`) into an
 * 8-bit sRGB bitmap, collapsing any wide-gamut value at the door (avoiding gamut
 * collapse). Instead we convert the ColorValue to working-LINEAR rgba and upload
 * the float texels into a 1×1 `rgba16float` texture tagged `trc: 'linear'` +
 * working gamut, so the composite consumes it with ZERO collapse and ZERO
 * re-encoding.
 *
 * The texels are STRAIGHT (un-premultiplied) RGBA `[r, g, b, alpha]`, matching
 * every other raster source: no pass sets `LAYER_FLAG_PREMULTIPLIED_SOURCE`, so
 * the shader samples all sources as straight alpha. Half-float (binary16) is the
 * composite working format (linear working space) and is filterable in core WebGPU —
 * a 1×1 constant reads back exactly regardless of the sampler's filter mode.
 *
 * PURE + GPU-FREE: yields plain data (an id + a `Uint16Array`). `SceneAssembler`
 * wraps it into an `UploadSource {kind:'raw', desc:{w:1,h:1,format:'rgba16float'}}`.
 *
 * @module core/engine/sources/SolidColorSource
 */

import type { ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';
import type { WorkingColorSpace } from '@opengpex/editor/core/types';

/** The GPU texture format the {@link SolidColorSource.texels} are encoded for. */
export const SOLID_COLOR_SOURCE_FORMAT = 'rgba16float' as const;

/** Plain-data product: a content-addressed asset key + the 1×1 rgba16float payload. */
export interface SolidColorSource {
  /**
   * Deterministic, content-addressed asset id. Two ColorValues that encode to the
   * SAME texels AND the same `space` share one resident texture (they are
   * pixel-identical). Editing the fill changes the id → `compositeSignature`
   * (keyed on `assetId`) re-composites; an identical re-assembly is a no-op upload.
   */
  readonly assetId: string;
  /** 1×1 rgba16float, STRAIGHT RGBA = `[r, g, b, alpha]` as binary16. */
  readonly texels: Uint16Array;
}

/**
 * Encode a {@link ColorValue} as a 1×1 wide-gamut solid-colour GPU source.
 *
 * The value is CONVERTED to the working space's linear light up front
 * (`toWorkingLinearRgba`: gamut matrix + working-space TRC decode) and the
 * texels hold working-LINEAR RGBA — so the scene node tags the source with
 * `trc: 'linear'` and the working gamut, and the sampling shader skips both
 * the TRC decode and the gamut alignment. Encoding the TRC-encoded `coords`
 * verbatim (an earlier design) mis-tagged the texture as `'srgb-trc'`, and a
 * non-sRGB colour was decoded with the wrong curve (2026-11-12 finding).
 * The conversion clamps out-of-working-gamut channels into the working range
 * (the desired behaviour for a FILL: a fill's colour must be representable in
 * the space it composites in). `alpha` rides channel A straight.
 */
export function buildSolidColorSource(
  value: ColorValue,
  workingSpace: WorkingColorSpace,
): SolidColorSource {
  const [lr, lg, lb, la] = toWorkingLinearRgba(value, workingSpace);
  const texels = new Uint16Array(4);
  texels[0] = floatToHalf(lr);
  texels[1] = floatToHalf(lg);
  texels[2] = floatToHalf(lb);
  texels[3] = floatToHalf(la);
  // Key from the ACTUAL uploaded bits + the working space: exact dedup of
  // pixel-identical uploads. Two colours from different source spaces that
  // convert to the same working-linear texels ARE pixel-identical and share
  // one resident texture.
  const assetId = `solid:${workingSpace}:${texels[0]}-${texels[1]}-${texels[2]}-${texels[3]}`;
  return { assetId, texels };
}
