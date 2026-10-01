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
 * collapse). Instead we upload the ColorValue's float `coords` straight into a 1×1
 * `rgba16float` texture and tag it with the colour's own `space` gamut, so the
 * existing per-source gamut-alignment machinery (`resolveSourceGamutId` →
 * `gamut_to_working`) carries it into the working space with ZERO collapse.
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
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';

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
 * `coords` are the TRC-ENCODED normalized channels in `value.space` (NOT linear
 * light — see {@link ColorValue}) and are written VERBATIM (no clamp: wide-gamut
 * channels may exceed 1); the sampling shader decodes (srgb-trc) and aligns
 * `space` → working. `alpha` rides channel A straight.
 */
export function buildSolidColorSource(value: ColorValue): SolidColorSource {
  const { r, g, b } = value.coords;
  const texels = new Uint16Array(4);
  texels[0] = floatToHalf(r);
  texels[1] = floatToHalf(g);
  texels[2] = floatToHalf(b);
  texels[3] = floatToHalf(value.alpha);
  // Key from the ACTUAL uploaded bits + `space`: exact dedup of pixel-identical
  // uploads, while the gamut tag (which rides `space`, not the texels) stays a
  // distinct dimension — two colours with identical coords in different spaces
  // are different sources.
  const assetId = `solid:${value.space}:${texels[0]}-${texels[1]}-${texels[2]}-${texels[3]}`;
  return { assetId, texels };
}
