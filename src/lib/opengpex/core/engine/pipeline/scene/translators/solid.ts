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
 * translators/solid.ts — the solid arm of the business → engine translation
 * seam (SceneTranslator family): the DECLARATIVE solid-fill source.
 *
 * A `color` layer's `fillColor` is a mathematical description, not pixels: this
 * translator converts it ONCE into working-gamut (ProPhoto RGB) LINEAR straight
 * alpha RGBA — the currency the composite's solid branch reads from the layer
 * uniform — and the renderer resolves it analytically (colour uniform, shared
 * 1×1 white texture, zero sampling of content). Unlike the retired
 * `SolidColorSource` byte workshop, the product carries NO assetId, NO texels
 * and NO cache entry: the fill is not an asset, so there is nothing to
 * register, upload, sweep or garbage-collect.
 *
 * Conversion semantics are IDENTICAL to the retired builder's: gamut matrix +
 * working-space TRC decode via `toWorkingLinearRgba`, out-of-working-gamut
 * channels clamped into the working range (a fill must be representable in the
 * space it composites in — the clamp lives inside `convertColorGamut`), alpha
 * rides channel A straight. The declaration itself is the identity: the scene
 * node tags it implicitly working-LINEAR / working-gamut (see
 * `Scene.LayerSource` solid variant), so no pool-record lookup ever happens.
 *
 * Pure + stateless: same fillColor + same working space ⇒ byte-identical
 * output; a fresh array per call is fine because the product is uniform data,
 * not upload-deduped bytes.
 *
 * @module core/engine/pipeline/scene/translators/solid
 */

import type { Layer } from '@opengpex/editor/core/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import type { LayerSource } from '../Scene';

/**
 * Translate a layer's solid-fill payload into the declarative
 * `{kind:'solid', color}` source, or `undefined` when the layer is not a
 * solid fill (no object-shaped `fillColor` — legacy string values and every
 * other kind fall through to the raster path).
 *
 * A layer already claimed by the vector spine is never offered here: the
 * assembler consults `layerToVectorSource` first and skips this translator on
 * a hit (payloads are disjoint, but the ordering keeps the boundary explicit).
 */
export function layerToSolidSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
): Extract<LayerSource, { kind: 'solid' }> | undefined {
  const fillColor = layer.fillColor;
  if (!fillColor || typeof fillColor !== 'object') return undefined;
  return {
    kind: 'solid',
    color: toWorkingLinearRgba(fillColor as ColorValue, workingSpace),
  };
}
