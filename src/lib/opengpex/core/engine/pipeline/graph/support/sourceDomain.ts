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
 * sourceDomain.ts — Single decision point for "are this layer's pixels already
 * linear light?" (linear light invariant).
 *
 * WHY THIS IS ONE SHARED FUNCTION: `CompositePass` (class-A `source-over`) and
 * `BlendPass` (the 15 class-B ping-pong modes) both have to set the same
 * `LAYER_FLAG_SOURCE_LINEAR` bit. If the two computed it independently they could
 * drift, and the symptom would be brutal to diagnose: the SAME image would look
 * correct on `source-over` and washed-out/dark the moment the user picked
 * `multiply` (or vice versa). One function, one truth.
 *
 * @module core/gpu/graph/support/sourceDomain
 */

import type { LayerNode } from '../../scene/Scene';

/**
 * Does this layer's compositing input already hold LINEAR light?
 *
 * Two independent reasons it might:
 *   1. `pipelineOverride` — the pixels come from a transient the pipeline itself
 *      produced (an `AdjustPrePass` bake and/or a `FilterPass` output). Those always
 *      write linear light regardless of what the original asset was, so this wins
 *      over the asset's own declaration.
 *   2. `layer.source.trc === 'linear'` — a genuinely linear source asset (linear
 *      TIFF / scRGB), judged per-ASSET from the decoder's reported interpretation.
 *
 * Otherwise the pixels are sRGB-TRC encoded and the shader must decode them. That
 * is the default for every 8-bit bitmap and for essentially all 16-bit TIFF/PNG.
 *
 * ⚠️ Never consult `frame.trc` here (see `LayerSource.trc` for why it is unusable).
 */
export function isSourceLinear(layer: LayerNode, pipelineOverride?: boolean): boolean {
  if (pipelineOverride) return true;
  return layer.source.kind === 'raster' && layer.source.trc === 'linear';
}
