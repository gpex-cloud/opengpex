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
 * sourceIntent.ts — Single decision point for "what out-of-box rendering intent
 * must the shader apply to this layer's source pixels?" (RAW processing,
 * boundary ③; render-intent axis method (a)).
 *
 * Third sibling of `sourceDomain.ts` / `sourceGamut.ts`. Exactly as those
 * centralise the `LAYER_FLAG_SOURCE_LINEAR` bit and the GAMUT_ID nibble so
 * `CompositePass` and `BlendPass` can never drift, this centralises the
 * RENDER_INTENT nibble packed into the same `flags` word (bits 8..9). One image
 * would otherwise render correct on `source-over` and wrong the moment the user
 * picked `multiply` — the classic split-path symptom.
 *
 * The returned integer is the SHADER contract, not the string enum:
 *   0 = SDR passthrough (no tone-map), 1 = generic Filmic S-curve,
 *   2 = DNG ProfileToneCurve LUT — matching the `normalize_source_components`
 *   intent switch and the RENDER_INTENT bit layout (`LAYER_RENDER_INTENT_SHIFT`).
 *
 * @module core/gpu/graph/support/sourceIntent
 */

import type { LayerNode } from '../../scene/Scene';

/**
 * Resolve the source render-intent id (0..2) the sampling shader must apply.
 *
 * Returns 0 (SDR passthrough, no tone-map) when:
 *   1. `pipelineOverride` — the pixels come from a pipeline transient (an
 *      `AdjustPrePass` bake and/or `FilterPass` output). ⚠️ CONSTRAINT A: that
 *      transient has ALREADY been tone-mapped once during the bake; applying the
 *      curve again on re-entry into `CompositePass` would crush shadows to black
 *      and blow contrast. The override MUST win, mirroring `isSourceLinear` /
 *      `resolveSourceGamutId` override precedence exactly.
 *   2. the source is not a raster asset — strokes/vectors are display-referred.
 *   3. the tag is absent or `'sdr'` — the OMITTED default. Every JPEG/PNG/text
 *      carries a baked look already and must pass through untouched.
 *
 * Otherwise it maps the per-ASSET `renderIntent` tag (carried forward explicitly
 * from the ingest decision — never re-sniffed here) to the
 * shader id.
 */
export function resolveSourceRenderIntent(layer: LayerNode, pipelineOverride?: boolean): number {
  if (pipelineOverride) return 0;
  if (layer.source.kind !== 'raster') return 0;
  let code = 0;
  switch (layer.source.renderIntent) {
    case 'filmic':
      code = 1;
      break;
    case 'dng-lut':
      code = 2;
      break;
    case 'sdr':
    default:
      code = 0;
      break;
  }
  return code;
}
