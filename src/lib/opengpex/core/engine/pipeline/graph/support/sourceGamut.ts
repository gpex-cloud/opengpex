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
 * sourceGamut.ts — Single decision point for "which source gamut must the shader
 * align to the working space (Display-P3)?"
 *
 * Sibling of `sourceDomain.ts`: exactly as `isSourceLinear` centralises the
 * `LAYER_FLAG_SOURCE_LINEAR` bit so `CompositePass` and `BlendPass` can never
 * drift, this centralises the GAMUT_ID nibble packed into the same `flags` word.
 * One image would otherwise look correct on `source-over` and wrong the moment the
 * user picked `multiply` — the classic split-path symptom.
 *
 * The returned integer is the SHADER contract, not the string enum:
 *   0 = already working / direct (no matrix), 1 = sRGB, 2 = Adobe RGB,
 *   3 = ProPhoto, 4 = Rec.2020 — matching the `gamut_to_working` switch in
 *   `colorspace.ts` and the GAMUT_ID bit layout (`LAYER_GAMUT_SHIFT`).
 *
 * @module core/gpu/graph/support/sourceGamut
 */

import type { LayerNode } from '../../scene/Scene';

/**
 * Resolve the source gamut id (0..4) the sampling shader must convert FROM.
 *
 * Returns 0 (direct passthrough) when:
 *   1. `pipelineOverride` — the pixels come from a pipeline transient (an
 *      `AdjustPrePass` bake and/or `FilterPass` output). Those already hold
 *      WORKING-gamut linear light, so no further conversion is legal (converting
 *      again would double-apply the matrix). This mirrors `isSourceLinear`'s
 *      override precedence exactly.
 *   2. the source is not a raster asset, or carries no `gamut` tag — the "omit ⇒
 *      direct" contract. An 8-bit browser bitmap DOES now
 *      carry a gamut tag (= frame.colorSpace ∈ {srgb, display-p3}), so it resolves
 *      to 1 or 0 below; the untagged path remains only for non-raster sources and
 *      pipeline transients already in working P3 → 0 → correctly left untouched.
 *   3. the tag is `display-p3` — the source IS the working gamut.
 *
 * Otherwise it maps the per-ASSET `gamut` tag to the shader id.
 */
export function resolveSourceGamutId(layer: LayerNode, pipelineOverride?: boolean): number {
  if (pipelineOverride) return 0;
  if (layer.source.kind !== 'raster') return 0;
  switch (layer.source.gamut) {
    case 'srgb':
      return 1;
    case 'adobe-rgb':
      return 2;
    case 'prophoto-rgb':
      return 3;
    case 'rec2020':
      return 4;
    case 'display-p3':
    default:
      return 0;
  }
}
